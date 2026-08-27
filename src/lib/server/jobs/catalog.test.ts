import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ts from 'typescript';
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
  JOB_RETRY_COMMAND_RESULT_CODES,
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
  isOperationalFailureCodeAllowedForJobKind,
  isJobRetryPolicyOutcomeAllowed,
  isRegisteredJobKind,
  safeOperationalFailureCode
} from './catalog';

const repositoryRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const catalogSourcePath = join(repositoryRoot, 'src/lib/server/jobs/catalog.ts');
const operationsMigrationPath = join(
  repositoryRoot, 'drizzle/0015_plan7a_operations_authority.sql'
);

type SafeFailureTuple = readonly [kind: string, message: string, code: string];

const unwrapExpression = (expression: ts.Expression): ts.Expression => {
  if (ts.isAsExpression(expression) || ts.isSatisfiesExpression(expression) ||
    ts.isParenthesizedExpression(expression)) return unwrapExpression(expression.expression);
  return expression;
};

const frozenObjectLiteral = (
  expression: ts.Expression | undefined,
  authorityName: string
): ts.ObjectLiteralExpression => {
  if (!expression) throw new Error(`${authorityName} must have an initializer`);
  const candidate = unwrapExpression(expression);
  const argument = ts.isCallExpression(candidate) &&
    ts.isPropertyAccessExpression(candidate.expression) &&
    ts.isIdentifier(candidate.expression.expression) &&
    candidate.expression.expression.text === 'Object' &&
    candidate.expression.name.text === 'freeze' && candidate.arguments.length === 1
    ? unwrapExpression(candidate.arguments[0]!)
    : undefined;
  if (!argument || !ts.isObjectLiteralExpression(argument)) {
    throw new Error(`${authorityName} must be an Object.freeze object literal`);
  }
  return argument;
};

const stringPropertyName = (property: ts.PropertyAssignment, owner: string): string => {
  if (!ts.isStringLiteral(property.name)) {
    throw new Error(`${owner} must contain only string-literal property assignments`);
  }
  return property.name.text;
};

const stringInitializer = (property: ts.PropertyAssignment, owner: string): string => {
  const initializer = unwrapExpression(property.initializer);
  if (!ts.isStringLiteral(initializer)) {
    throw new Error(`${owner}.${property.name.getText()} must have a string-literal value`);
  }
  return initializer.text;
};

const safeFailuresFromCatalogSource = (source: string): readonly SafeFailureTuple[] => {
  const syntax = ts.createSourceFile(
    'src/lib/server/jobs/catalog.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS
  );
  const owners = syntax.statements.flatMap((statement) => {
    if (!ts.isVariableStatement(statement)) return [];
    return statement.declarationList.declarations
      .filter((declaration) => ts.isIdentifier(declaration.name) &&
        declaration.name.text === 'SAFE_FAILURES')
      .map((declaration) => ({ statement, declaration }));
  });
  if (owners.length !== 1) {
    throw new Error('catalog.ts must have exactly one top-level SAFE_FAILURES declaration');
  }
  const owner = owners[0];
  if (!owner) throw new Error('catalog.ts SAFE_FAILURES declaration is unavailable');
  const { statement, declaration } = owner;
  const directlyExported = statement.modifiers?.some(
    ({ kind }) => kind === ts.SyntaxKind.ExportKeyword
  ) ?? false;
  const separatelyExported = syntax.statements.some((candidate) => {
    if (ts.isExportAssignment(candidate)) {
      const expression = unwrapExpression(candidate.expression);
      return ts.isIdentifier(expression) && expression.text === 'SAFE_FAILURES';
    }
    return ts.isExportDeclaration(candidate) && !candidate.moduleSpecifier &&
      candidate.exportClause !== undefined && ts.isNamedExports(candidate.exportClause) &&
      candidate.exportClause.elements.some((element) =>
        (element.propertyName ?? element.name).text === 'SAFE_FAILURES'
      );
  });
  if (directlyExported || separatelyExported) {
    throw new Error('SAFE_FAILURES must remain private to catalog.ts');
  }
  if ((statement.declarationList.flags & ts.NodeFlags.Const) === 0) {
    throw new Error('SAFE_FAILURES must remain a const declaration');
  }

  const authority = frozenObjectLiteral(declaration.initializer, 'SAFE_FAILURES');
  const tuples: SafeFailureTuple[] = [];
  const identities = new Set<string>();
  for (const kindProperty of authority.properties) {
    if (!ts.isPropertyAssignment(kindProperty)) {
      throw new Error('SAFE_FAILURES must contain only property assignments');
    }
    const kind = stringPropertyName(kindProperty, 'SAFE_FAILURES');
    const failures = frozenObjectLiteral(kindProperty.initializer, `SAFE_FAILURES[${kind}]`);
    for (const messageProperty of failures.properties) {
      if (!ts.isPropertyAssignment(messageProperty)) {
        throw new Error(`SAFE_FAILURES[${kind}] must contain only property assignments`);
      }
      const message = stringPropertyName(messageProperty, `SAFE_FAILURES[${kind}]`);
      const identity = `${kind}\u0000${message}`;
      if (identities.has(identity)) throw new Error(`duplicate SAFE_FAILURES entry: ${identity}`);
      identities.add(identity);
      tuples.push([
        kind,
        message,
        stringInitializer(messageProperty, `SAFE_FAILURES[${kind}]`)
      ]);
    }
  }
  return tuples;
};

type SqlTokenKind = 'dollar' | 'identifier' | 'number' | 'string' | 'symbol' | 'word';

interface SqlToken {
  readonly kind: SqlTokenKind;
  readonly text: string;
}

const quotedSqlToken = (
  sql: string,
  offset: number,
  quote: "'" | '"',
  kind: 'identifier' | 'string'
): readonly [token: SqlToken, end: number] => {
  const backslashEscapes = quote === "'" && isEscapeString(sql, offset);
  let cursor = offset + 1;
  let value = '';
  while (cursor < sql.length) {
    if (backslashEscapes && sql[cursor] === '\\' && cursor + 1 < sql.length) {
      value += sql[cursor + 1];
      cursor += 2;
      continue;
    }
    if (sql[cursor] !== quote) {
      value += sql[cursor];
      cursor += 1;
      continue;
    }
    if (sql[cursor + 1] === quote) {
      value += quote;
      cursor += 2;
      continue;
    }
    return [{ kind, text: value }, cursor + 1];
  }
  throw new Error(`unterminated SQL ${kind}`);
};

const sqlTokens = (sql: string): readonly SqlToken[] => {
  const tokens: SqlToken[] = [];
  let cursor = 0;
  while (cursor < sql.length) {
    if (/\s/u.test(sql[cursor]!)) {
      cursor += 1;
      continue;
    }
    if (sql.startsWith('--', cursor)) {
      const end = sql.indexOf('\n', cursor + 2);
      cursor = end < 0 ? sql.length : end + 1;
      continue;
    }
    if (sql.startsWith('/*', cursor)) {
      let depth = 1;
      cursor += 2;
      while (cursor < sql.length && depth > 0) {
        if (sql.startsWith('/*', cursor)) {
          depth += 1;
          cursor += 2;
        } else if (sql.startsWith('*/', cursor)) {
          depth -= 1;
          cursor += 2;
        } else {
          cursor += 1;
        }
      }
      if (depth > 0) throw new Error('unterminated SQL block comment');
      continue;
    }
    if (sql[cursor] === "'") {
      const [token, end] = quotedSqlToken(sql, cursor, "'", 'string');
      tokens.push(token);
      cursor = end;
      continue;
    }
    if (sql[cursor] === '"') {
      const [token, end] = quotedSqlToken(sql, cursor, '"', 'identifier');
      tokens.push(token);
      cursor = end;
      continue;
    }
    const dollarTag = sql[cursor] === '$' ? dollarTagAt(sql, cursor) : undefined;
    if (dollarTag) {
      const bodyStart = cursor + dollarTag.length;
      const close = sql.indexOf(dollarTag, bodyStart);
      if (close < 0) throw new Error(`unterminated SQL dollar quote ${dollarTag}`);
      tokens.push({ kind: 'dollar', text: sql.slice(bodyStart, close) });
      cursor = close + dollarTag.length;
      continue;
    }
    if (/[A-Za-z_]/u.test(sql[cursor]!)) {
      const start = cursor;
      cursor += 1;
      while (cursor < sql.length && /[A-Za-z0-9_$]/u.test(sql[cursor]!)) cursor += 1;
      tokens.push({ kind: 'word', text: sql.slice(start, cursor) });
      continue;
    }
    if (/[0-9]/u.test(sql[cursor]!)) {
      const start = cursor;
      cursor += 1;
      while (cursor < sql.length && /[0-9]/u.test(sql[cursor]!)) cursor += 1;
      tokens.push({ kind: 'number', text: sql.slice(start, cursor) });
      continue;
    }
    tokens.push({ kind: 'symbol', text: sql[cursor]! });
    cursor += 1;
  }
  return tokens;
};

const isSqlWord = (token: SqlToken | undefined, expected: string): boolean =>
  token?.kind === 'word' && token.text.toLowerCase() === expected;

const isSqlIdentifier = (token: SqlToken | undefined, expected: string): boolean =>
  token !== undefined && (token.kind === 'word'
    ? token.text.toLowerCase() === expected
    : token.kind === 'identifier' && token.text === expected);

const safeFailureFunctionBody = (sql: string): string => {
  const tokens = sqlTokens(sql);
  const bodies: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    if (!isSqlWord(tokens[index], 'create') ||
      (index > 0 && (tokens[index - 1]?.kind !== 'symbol' ||
        tokens[index - 1]?.text !== ';'))) continue;
    let cursor = index + 1;
    if (isSqlWord(tokens[cursor], 'or') && isSqlWord(tokens[cursor + 1], 'replace')) cursor += 2;
    if (!isSqlWord(tokens[cursor], 'function')) continue;
    cursor += 1;
    if (!isSqlIdentifier(tokens[cursor], 'public') || tokens[cursor + 1]?.text !== '.' ||
      !isSqlIdentifier(tokens[cursor + 2], 'plan7a_operations_safe_failure_code') ||
      tokens[cursor + 3]?.text !== '(' || !isSqlIdentifier(tokens[cursor + 4], 'text') ||
      tokens[cursor + 5]?.text !== ',' || !isSqlIdentifier(tokens[cursor + 6], 'text') ||
      tokens[cursor + 7]?.text !== ')') continue;
    cursor += 8;
    const headerStart = cursor;
    while (cursor < tokens.length && tokens[cursor]?.text !== ';') {
      if (isSqlWord(tokens[cursor], 'as') && tokens[cursor + 1]?.kind === 'dollar' &&
        tokens[cursor + 2]?.text === ';') {
        const header = tokens.slice(headerStart, cursor);
        const shortCircuitsNulls = header.some((token, headerIndex) =>
          isSqlWord(token, 'strict') ||
          (isSqlWord(token, 'returns') && isSqlWord(header[headerIndex + 1], 'null') &&
            isSqlWord(header[headerIndex + 2], 'on') &&
            isSqlWord(header[headerIndex + 3], 'null') &&
            isSqlWord(header[headerIndex + 4], 'input'))
        );
        if (shortCircuitsNulls) {
          throw new Error('safe-failure SQL must remain CALLED ON NULL INPUT');
        }
        bodies.push(tokens[cursor + 1]!.text);
        break;
      }
      cursor += 1;
    }
  }
  if (bodies.length !== 1) {
    throw new Error('0015 must contain exactly one executable safe-failure function(text,text)');
  }
  return bodies[0]!;
};

const safeFailuresFromOperationsMigration = (sql: string): readonly SafeFailureTuple[] => {
  const tokens = sqlTokens(safeFailureFunctionBody(sql));
  let cursor = 0;
  const consume = (kind: SqlTokenKind, text: string): SqlToken => {
    const token = tokens[cursor];
    const matches = token?.kind === kind && (kind === 'word'
      ? token.text.toLowerCase() === text
      : token.text === text);
    if (!matches) throw new Error(`safe-failure SQL expected ${kind} ${text} at token ${cursor}`);
    cursor += 1;
    return token;
  };
  const consumeIdentifier = (text: string): void => {
    if (!isSqlIdentifier(tokens[cursor], text)) {
      throw new Error(`safe-failure SQL expected identifier ${text} at token ${cursor}`);
    }
    cursor += 1;
  };
  const consumeParameter = (ordinal: string): void => {
    consume('symbol', '$');
    consume('number', ordinal);
  };
  const consumeString = (): string => {
    const token = tokens[cursor];
    if (token?.kind !== 'string') {
      throw new Error(`safe-failure SQL expected string at token ${cursor}`);
    }
    cursor += 1;
    return token.text;
  };

  consume('word', 'select');
  consume('word', 'case');
  consume('word', 'when');
  consumeParameter('1');
  consume('word', 'not');
  consume('word', 'in');
  consume('symbol', '(');
  const registeredKinds: string[] = [];
  while (tokens[cursor]?.kind === 'string') {
    registeredKinds.push(consumeString());
    if (tokens[cursor]?.text !== ',') break;
    consume('symbol', ',');
  }
  consume('symbol', ')');
  consume('word', 'then');
  if (consumeString() !== 'unregistered_job_kind') {
    throw new Error('safe-failure SQL must classify unknown kinds as unregistered_job_kind');
  }
  if (JSON.stringify(registeredKinds) !== JSON.stringify(REGISTERED_JOB_KINDS)) {
    throw new Error('safe-failure SQL registered-kind branch must match REGISTERED_JOB_KINDS');
  }
  consume('word', 'when');
  consumeParameter('2');
  consume('word', 'is');
  consume('word', 'null');
  consume('word', 'then');
  consume('word', 'null');
  consume('word', 'else');
  consumeIdentifier('coalesce');
  consume('symbol', '(');
  consume('symbol', '(');
  consume('word', 'select');
  consumeIdentifier('failure');
  consume('symbol', '.');
  consumeIdentifier('code');
  consume('word', 'from');
  consume('symbol', '(');
  consume('word', 'values');

  const tuples: SafeFailureTuple[] = [];
  do {
    consume('symbol', '(');
    const kind = consumeString();
    consume('symbol', ',');
    const message = consumeString();
    consume('symbol', ',');
    const code = consumeString();
    consume('symbol', ')');
    tuples.push([kind, message, code]);
    if (tokens[cursor]?.text !== ',') break;
    consume('symbol', ',');
  } while (tokens[cursor]?.text === '(');

  consume('symbol', ')');
  consume('word', 'as');
  consumeIdentifier('failure');
  consume('symbol', '(');
  consumeIdentifier('kind');
  consume('symbol', ',');
  consumeIdentifier('message');
  consume('symbol', ',');
  consumeIdentifier('code');
  consume('symbol', ')');
  consume('word', 'where');
  consumeIdentifier('failure');
  consume('symbol', '.');
  consumeIdentifier('kind');
  consume('symbol', '=');
  consumeParameter('1');
  consume('word', 'and');
  consumeIdentifier('failure');
  consume('symbol', '.');
  consumeIdentifier('message');
  consume('symbol', '=');
  consumeParameter('2');
  consume('symbol', ')');
  consume('symbol', ',');
  if (consumeString() !== 'unexpected_failure') {
    throw new Error('safe-failure SQL must classify unmapped failures as unexpected_failure');
  }
  consume('symbol', ')');
  consume('word', 'end');
  if (tokens[cursor]?.text === ';') consume('symbol', ';');
  if (cursor !== tokens.length) {
    throw new Error(`safe-failure SQL has unexpected executable tokens after token ${cursor}`);
  }
  return tuples;
};

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
  select catalog.kind, catalog.label, catalog.max_attempts,
    catalog.automatic_retry_owner, catalog.retry_disposition,
    catalog.policy_adapter, catalog.policy_availability,
    catalog.provider_verification_required, catalog.provider_calls_in_plan7a,
    catalog.administrator_retry_excluded, catalog.safe_statuses,
    catalog.diagnostic_generation, array(
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

const catalogSafeFailureAuthority = safeFailuresFromCatalogSource(
  readFileSync(catalogSourcePath, 'utf8')
);

const typescriptSafeFailureDecoys = [
  { label: 'line comment', source: '// const SAFE_FAILURES = Object.freeze({});' },
  { label: 'block comment', source: '/* const SAFE_FAILURES = Object.freeze({}); */' },
  { label: 'quoted string', source: "const quoted = 'const SAFE_FAILURES = Object.freeze({})';" },
  { label: 'template string', source: 'const quoted = `const SAFE_FAILURES = Object.freeze({})`;' }
] as const;

const safeFailureFunctionDecoy = [
  'CREATE FUNCTION "public"."plan7a_operations_safe_failure_code"(text,text)',
  'RETURNS text LANGUAGE sql AS $body$ SELECT NULL $body$;'
].join('\n');
const sqlSafeFailureDecoys = [
  {
    label: 'line comments',
    source: safeFailureFunctionDecoy.split('\n').map((line) => `-- ${line}`).join('\n')
  },
  { label: 'block comment', source: `/* ${safeFailureFunctionDecoy} */` },
  {
    label: 'quoted string',
    source: `SELECT '${safeFailureFunctionDecoy.replaceAll("'", "''")}';`
  },
  { label: 'dollar-quoted string', source: `SELECT $decoy$${safeFailureFunctionDecoy}$decoy$;` },
  {
    label: 'quoted identifier',
    source: `SELECT 1 AS "${safeFailureFunctionDecoy.replaceAll('"', '""')}";`
  }
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
    expect(JOB_RETRY_COMMAND_RESULT_CODES).toEqual([
      'rearmed_existing', 'successor_enqueued', 'already_current',
      'retry_not_supported', 'retry_policy_not_enabled',
      'provider_recovery_not_enabled', 'target_not_failed', 'target_state_changed',
      'domain_state_not_retryable', 'source_unavailable', 'actor_not_authorized',
      'retry_command_invalid', 'retry_command_exhausted', 'unexpected_failure'
    ]);
    expect(Object.isFrozen(JOB_RETRY_COMMAND_RESULT_CODES)).toBe(true);
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

  it('keeps executable SQL safe failures byte-identical to the private TypeScript authority', () => {
    const sqlSafeFailures = safeFailuresFromOperationsMigration(
      readFileSync(operationsMigrationPath, 'utf8')
    );

    expect(catalogSafeFailureAuthority.length).toBeGreaterThan(0);
    expect(JSON.stringify(sqlSafeFailures)).toBe(JSON.stringify(catalogSafeFailureAuthority));
  });

  it('rejects a parenthesized default export of the private TypeScript authority', () => {
    const exportedSource = `
      const SAFE_FAILURES = Object.freeze({
        'registered.kind': Object.freeze({ 'message': 'unexpected_failure' })
      });
      export default (SAFE_FAILURES);
    `;
    expect(() => safeFailuresFromCatalogSource(exportedSource))
      .toThrow('SAFE_FAILURES must remain private to catalog.ts');
  });

  it.each(['STRICT', 'RETURNS NULL ON NULL INPUT'] as const)(
    'rejects SQL $nullBehavior that bypasses unknown-kind classification for null errors',
    (nullBehavior) => {
      const migration = readFileSync(operationsMigrationPath, 'utf8').replace(/\r\n?/gu, '\n');
      const header = [
        'CREATE FUNCTION "public"."plan7a_operations_safe_failure_code"(text,text)',
        'RETURNS text',
        'LANGUAGE sql STABLE'
      ].join('\n');
      const nullShortCircuitMigration = migration.replace(header, `${header} ${nullBehavior}`);
      expect(nullShortCircuitMigration).not.toBe(migration);
      expect(() => safeFailuresFromOperationsMigration(nullShortCircuitMigration))
        .toThrow('safe-failure SQL must remain CALLED ON NULL INPUT');
    }
  );

  it.each(typescriptSafeFailureDecoys)(
    'rejects a TypeScript $label as a safe-failure authority',
    ({ source }) => {
      expect(() => safeFailuresFromCatalogSource(source))
        .toThrow('exactly one top-level SAFE_FAILURES declaration');
    }
  );

  it.each(sqlSafeFailureDecoys)(
    'rejects a SQL $label as an executable safe-failure function',
    ({ source }) => {
      expect(() => safeFailuresFromOperationsMigration(source))
        .toThrow('exactly one executable safe-failure function(text,text)');
    }
  );

  it('classifies every persisted safe failure from the private source authority', () => {
    for (const [kind, lastError, expected] of catalogSafeFailureAuthority) {
      expect(safeOperationalFailureCode(kind, lastError), `${kind}:${lastError}`).toBe(expected);
    }
  });

  it('selects only safe failure codes reachable for the exact registered kind', () => {
    const reachable = catalogSafeFailureAuthority
      .filter(([kind, , code], index, tuples) => tuples.findIndex(
        ([candidateKind, , candidateCode]) => candidateKind === kind && candidateCode === code
      ) === index)
      .map(([kind, , code]) => [kind, code] as const);
    for (const [kind, code] of reachable) {
      expect(isOperationalFailureCodeAllowedForJobKind(kind, code), `${kind}:${code}`).toBe(true);
    }
    for (const kind of REGISTERED_JOB_KINDS) {
      expect(isOperationalFailureCodeAllowedForJobKind(kind, null)).toBe(true);
      expect(isOperationalFailureCodeAllowedForJobKind(kind, 'unexpected_failure')).toBe(true);
    }
    expect(isOperationalFailureCodeAllowedForJobKind(
      'commerce.stripe-event', 'retry_command_exhausted'
    )).toBe(false);
    expect(isOperationalFailureCodeAllowedForJobKind(
      'outbox.dispatch', 'domain_state_not_retryable'
    )).toBe(false);
    expect(isOperationalFailureCodeAllowedForJobKind(
      'commerce.financial-admin-command', 'source_unavailable'
    )).toBe(false);
    for (const [kind, code] of [
      ['unregistered', 'unregistered_job_kind'],
      ['commerce.stripe-event', 'unregistered_job_kind'],
      ['commerce.stripe-event', 'raw_provider_error'],
      [null, null]
    ]) expect(isOperationalFailureCodeAllowedForJobKind(kind, code)).toBe(false);
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

    expect(safeOperationalFailureCode('unregistered.kind', null))
      .toBe('unregistered_job_kind');

    const hostile = Object.defineProperty({}, 'toString', {
      get: () => { throw new Error('must not inspect hostile lastError'); }
    });
    expect(safeOperationalFailureCode('unregistered.kind', hostile)).toBe('unregistered_job_kind');
  });
});
